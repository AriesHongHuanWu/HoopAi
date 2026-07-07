/**
 * One team's half of the broadcast scorebug: a surface panel with a
 * team-tinted top rule and HOME/AWAY side tag, an editable name, a giant
 * tabular score numeral (tap = +1) that springs under the finger and pops
 * when the score lands, plus −1/+2/+3 quick corrections. Self-contained —
 * talks to the caller only via callbacks. All motion respects the system
 * reduce-motion setting (pressed fills still flip instantly for feedback).
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { color, font, motion, radius, space, touch, type } from '@/constants/tokens';

const NAME_MAX_LENGTH = 24;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Spring configs: crisp catch on press-in, soft settle on release. */
const SPRING_IN = { damping: 22, stiffness: 460 } as const;
const SPRING_OUT = { damping: 13, stiffness: 300 } as const;

/** '#RRGGBB' → rgba() at the given alpha; neutral raised-surface fallback. */
function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return `rgba(38, 34, 32, ${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function QuickButton({
  label,
  accessibilityLabel,
  onPress,
  tone = 'default',
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  tone?: 'default' | 'accent';
}) {
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const press = useSharedValue(0);
  const restBg =
    tone === 'accent'
      ? withAlpha(color.accent, 0.12)
      : withAlpha(color.surfaceRaised, 0);
  const pressedBg =
    tone === 'accent'
      ? withAlpha(color.accent, 0.26)
      : withAlpha(color.surfaceRaised, 1);
  const anim = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    backgroundColor: interpolateColor(press.value, [0, 1], [restBg, pressedBg]),
  }));
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onPressIn={() => {
        press.value = reducedMotion ? 1 : withTiming(1, { duration: motion.instant });
        if (!reducedMotion) scale.value = withSpring(0.92, SPRING_IN);
      }}
      onPressOut={() => {
        press.value = reducedMotion ? 0 : withTiming(0, { duration: motion.quick });
        if (!reducedMotion) scale.value = withSpring(1, SPRING_OUT);
      }}
      style={[
        styles.quickButton,
        tone === 'accent' && styles.quickButtonAccent,
        anim,
      ]}
    >
      <Text
        style={[
          styles.quickButtonLabel,
          tone === 'accent' && styles.quickButtonLabelAccent,
        ]}
      >
        {label}
      </Text>
    </AnimatedPressable>
  );
}

export function TeamPanel({
  teamLabel,
  name,
  score,
  tint,
  onRename,
  onAdd,
}: {
  /** "Home" / "Away" — side tag + a11y copy; never replaces a custom name. */
  teamLabel: string;
  name: string;
  score: number;
  /** Accent color for this side (leather for home, info blue for away). */
  tint: string;
  onRename: (name: string) => void;
  onAdd: (delta: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const reducedMotion = useReducedMotion();

  // Score tap: spring scale on the whole target + team-tinted pressed fill.
  const pressScale = useSharedValue(1);
  const pressBg = useSharedValue(0);
  const tapAnim = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
    backgroundColor: interpolateColor(
      pressBg.value,
      [0, 1],
      [withAlpha(tint, 0), withAlpha(tint, 0.14)],
    ),
  }));

  // The numeral itself pops when the score lands — skipped on first render
  // so restoring a persisted game doesn't bounce.
  const popScale = useSharedValue(1);
  const numeralAnim = useAnimatedStyle(() => ({
    transform: [{ scale: popScale.value }],
  }));
  const firstScoreRender = useRef(true);
  useEffect(() => {
    if (firstScoreRender.current) {
      firstScoreRender.current = false;
      return;
    }
    if (reducedMotion) return;
    popScale.value = withSequence(
      withSpring(1.08, { damping: 18, stiffness: 520 }),
      withSpring(1, { damping: 14, stiffness: 240 }),
    );
  }, [score, reducedMotion, popScale]);

  const commitName = () => {
    setEditing(false);
    const next = draft.trim();
    onRename(next.length > 0 ? next : teamLabel);
  };

  const displayName = name.trim().length > 0 ? name : teamLabel;

  return (
    <View style={styles.panel}>
      <View style={[styles.tintRule, { backgroundColor: tint }]} />
      <Text style={styles.sideTag}>{teamLabel.toUpperCase()}</Text>

      {editing ? (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={commitName}
          onBlur={commitName}
          autoFocus
          selectTextOnFocus
          maxLength={NAME_MAX_LENGTH}
          returnKeyType="done"
          placeholder={teamLabel}
          placeholderTextColor={color.textFaint}
          accessibilityLabel={`${teamLabel} team name`}
          selectionColor={tint}
          style={[styles.nameInput, { color: tint }]}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Team name: ${displayName}. Edit`}
          accessibilityHint="Opens a text field to rename this team"
          onPress={() => {
            setDraft(name);
            setEditing(true);
          }}
          hitSlop={space.sm}
          style={({ pressed }) => [pressed && styles.namePressed]}
        >
          <Text style={[styles.nameText, { color: tint }]} numberOfLines={1}>
            {displayName.toUpperCase()}
          </Text>
        </Pressable>
      )}

      <AnimatedPressable
        accessibilityRole="button"
        accessibilityLabel={`${displayName} score: ${score}. Tap to add one point`}
        accessibilityHint="Adds one point"
        onPress={() => onAdd(1)}
        onPressIn={() => {
          pressBg.value = reducedMotion ? 1 : withTiming(1, { duration: motion.instant });
          if (!reducedMotion) pressScale.value = withSpring(0.95, SPRING_IN);
        }}
        onPressOut={() => {
          pressBg.value = reducedMotion ? 0 : withTiming(0, { duration: motion.quick });
          if (!reducedMotion) pressScale.value = withSpring(1, SPRING_OUT);
        }}
        style={[styles.scoreTap, tapAnim]}
      >
        <Animated.View style={numeralAnim}>
          <Text style={styles.scoreNumeral}>{score}</Text>
        </Animated.View>
      </AnimatedPressable>

      <View style={styles.controls}>
        <QuickButton
          label="−1"
          accessibilityLabel={`Subtract one point from ${displayName}`}
          onPress={() => onAdd(-1)}
        />
        <QuickButton
          label="+2"
          accessibilityLabel={`Add two points to ${displayName}`}
          onPress={() => onAdd(2)}
          tone="accent"
        />
        <QuickButton
          label="+3"
          accessibilityLabel={`Add three points to ${displayName}`}
          onPress={() => onAdd(3)}
          tone="accent"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    overflow: 'hidden',
  },
  /** Team-tinted broadcast rule pinned to the panel's top edge. */
  tintRule: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  sideTag: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1.5,
  },
  nameText: {
    ...type.heading,
    letterSpacing: 1,
    maxWidth: 200,
  },
  namePressed: {
    opacity: 0.7,
  },
  nameInput: {
    ...type.heading,
    letterSpacing: 1,
    minWidth: 120,
    maxWidth: 200,
    textAlign: 'center',
    borderBottomWidth: 1,
    borderColor: color.border,
    paddingVertical: 2,
  },
  scoreTap: {
    minWidth: touch.minTarget * 2,
    minHeight: touch.minTarget * 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
  },
  scoreNumeral: {
    fontFamily: font.display,
    fontSize: 120,
    lineHeight: 124,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  controls: {
    flexDirection: 'row',
    gap: space.sm,
  },
  quickButton: {
    minWidth: touch.minTarget,
    minHeight: touch.minTarget,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickButtonAccent: {
    borderColor: color.accent,
  },
  quickButtonLabel: {
    ...type.heading,
    color: color.textDim,
  },
  quickButtonLabelAccent: {
    color: color.accent,
  },
});
