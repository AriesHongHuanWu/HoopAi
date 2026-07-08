/**
 * FormStudioButton — the entry point into Form Studio (src/app/formstudio.tsx).
 *
 * Exported as a standalone component so it can be dropped into the session
 * summary and the History detail screen without those screens importing the
 * route string or navigation params themselves (and without this feature
 * having to edit index.tsx / shotlab.tsx). Mirrors the existing "Shot Lab"
 * PillButton: same look, same disabled-when-empty behavior.
 *
 * Pass `sid` (a persisted session row id) to open the studio on a HISTORY
 * session; omit it to open on the LIVE session.
 */
import { router } from 'expo-router';
import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { PillButton } from '@/components/ui';

export interface FormStudioButtonProps {
  /**
   * History session row id to analyze. Omit for the live session (the studio
   * reads the live session store when no id is present).
   */
  sid?: number | string;
  /** True while the caller has no shots yet — greys the button out. */
  disabled?: boolean;
  /** Ghost variant for secondary placement (defaults to primary). */
  variant?: 'primary' | 'ghost';
  label?: string;
  style?: StyleProp<ViewStyle>;
}

export function FormStudioButton({
  sid,
  disabled = false,
  variant = 'primary',
  label = 'Form Studio — motion vs the pros',
  style,
}: FormStudioButtonProps) {
  return (
    <PillButton
      label={label}
      icon="body-outline"
      variant={variant}
      disabled={disabled}
      onPress={() => {
        if (sid != null) {
          router.push({ pathname: '/formstudio', params: { sid: String(sid) } });
        } else {
          router.push('/formstudio');
        }
      }}
      style={style}
    />
  );
}
