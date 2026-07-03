/**
 * One team's panel on the two-team scoreboard: editable name, a huge
 * tappable score numeral (tap = +1), a minus correction and +2/+3 quick
 * buttons. Self-contained — talks to the caller only via callbacks.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { color, font, radius, space, touch, type } from '@/constants/tokens';

const NAME_MAX_LENGTH = 24;

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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [
        styles.quickButton,
        tone === 'accent' && styles.quickButtonAccent,
        pressed && styles.quickButtonPressed,
      ]}
    >
      <Text style={[styles.quickButtonLabel, tone === 'accent' && styles.quickButtonLabelAccent]}>
        {label}
      </Text>
    </Pressable>
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
  /** "Home" / "Away" — used in a11y copy, never shown when a custom name is set. */
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

  const commitName = () => {
    setEditing(false);
    const next = draft.trim();
    onRename(next.length > 0 ? next : teamLabel);
  };

  const displayName = name.trim().length > 0 ? name : teamLabel;

  return (
    <View style={styles.panel}>
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

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${displayName} score: ${score}. Tap to add one point`}
        accessibilityHint="Adds one point"
        onPress={() => onAdd(1)}
        style={({ pressed }) => [styles.scoreTap, pressed && styles.scoreTapPressed]}
      >
        <Text style={styles.scoreNumeral}>{score}</Text>
      </Pressable>

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
    alignItems: 'center',
    gap: space.md,
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
  },
  scoreTapPressed: {
    backgroundColor: color.surfaceRaised,
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
    backgroundColor: color.accentTint,
  },
  quickButtonPressed: {
    backgroundColor: color.surfaceRaised,
  },
  quickButtonLabel: {
    ...type.heading,
    color: color.textDim,
  },
  quickButtonLabelAccent: {
    color: color.accent,
  },
});
