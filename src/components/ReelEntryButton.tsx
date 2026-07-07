/**
 * ReelEntryButton — the one-tap entry point into a session's highlight reel
 * (src/app/reel/[sessionId].tsx). Kept as its own component so the summary
 * and history screens can drop it in with a single line.
 */
import { router } from 'expo-router';
import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { PillButton } from './ui';

export function ReelEntryButton({
  sessionId,
  variant = 'primary',
  style,
}: {
  sessionId: number;
  /** PillButton variant; ghost for secondary placements. */
  variant?: 'primary' | 'ghost';
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <PillButton
      label="Get my reel"
      icon="film"
      variant={variant}
      onPress={() => router.push(`/reel/${sessionId}`)}
      style={style}
    />
  );
}
