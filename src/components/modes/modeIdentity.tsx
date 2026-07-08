/**
 * modeIdentity — the visual identity card for each game mode.
 *
 * Every mode carries one Ionicons glyph, one accent color and a matching 14%
 * tint wash, used consistently across the mode picker, the live ModeBanner and
 * the ModeComplete sheet so a mode is recognizable at a glance anywhere in the
 * app. `glance` is the rules-at-a-glance chip copy for the picker.
 *
 * Presentation constants plus one tiny renderer ({@link ModeMark}) — accents
 * are tokens (or 14% washes of token hues, matching the tint convention in
 * tokens.ts); no game logic lives here.
 */
import React, { type ComponentProps } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { color } from '../../constants/tokens';
import type { DrillId } from '../../core/drills';
import type { GameModeId } from '../../core/types';

export interface ModeIdentity {
  /** Dedicated Ionicons glyph — the mode's mark. */
  icon: ComponentProps<typeof Ionicons>['name'];
  /** Accent hue for rings, taglines, progress fills. */
  accent: string;
  /** 14% wash of the accent for badge/chip fills. */
  tint: string;
  /** Rules-at-a-glance chips for the picker (2 short fragments max). */
  glance: readonly string[];
}

export const MODE_IDENTITY: Record<GameModeId, ModeIdentity> = {
  free: {
    icon: 'basketball',
    accent: color.accent,
    tint: color.accentTint,
    glance: ['Open run', 'No clock'],
  },
  aroundTheWorld: {
    icon: 'earth',
    accent: color.info,
    tint: 'rgba(79, 141, 232, 0.14)',
    glance: ['5 spots', 'Make to move'],
  },
  spotShooting: {
    icon: 'locate',
    accent: color.make,
    tint: color.makeTint,
    glance: ['5 spots', '% per spot'],
  },
  timed: {
    icon: 'stopwatch',
    accent: color.unsure,
    tint: 'rgba(232, 184, 79, 0.14)',
    glance: ['60 seconds', 'Most makes'],
  },
  threePoint: {
    icon: 'cash',
    accent: color.threePt,
    tint: color.threePtTint,
    glance: ['25 balls', 'Money 5th'],
  },
  ftStreak: {
    icon: 'flame',
    accent: color.miss,
    tint: color.missTint,
    glance: ['Free throws', 'In a row'],
  },
  horse: {
    icon: 'text',
    accent: color.textDim,
    tint: 'rgba(179, 172, 165, 0.14)',
    glance: ['Call it', '5 letters'],
  },
  ghost: {
    icon: 'walk',
    accent: color.ghost,
    tint: color.ghostTint,
    glance: ['Your past run', 'Same clock'],
  },
} as const;

/**
 * Visual identity for each structured DRILL (src/core/drills.ts). Drills host on
 * the spotShooting mode, so they need their own accent/tint/glance for the
 * picker cards (the mode identity would paint them all the same green). Icons
 * live on the drill catalog itself; accents are drawn from the same token hues
 * as the modes so the picker stays one family.
 */
export interface DrillIdentity {
  accent: string;
  tint: string;
  glance: readonly string[];
}

export const DRILL_IDENTITY: Record<DrillId, DrillIdentity> = {
  corners3: {
    accent: color.threePt,
    tint: color.threePtTint,
    glance: ['Both corners', '3PT'],
  },
  ftLadder: {
    accent: color.make,
    tint: color.makeTint,
    glance: ['10 free throws', 'From the line'],
  },
  midClock: {
    accent: color.info,
    tint: 'rgba(79, 141, 232, 0.14)',
    glance: ['5 spots', '3 makes each'],
  },
  aroundKey: {
    accent: color.accent,
    tint: color.accentTint,
    glance: ['6 spots', 'At the rim'],
  },
  catchShoot10: {
    accent: color.ghost,
    tint: color.ghostTint,
    glance: ['10 makes', '15 attempts'],
  },
} as const;

/**
 * ModeMark — a mode's Ionicons glyph on its identity-tint circle: the same
 * mark the picker, ModeBanner and ModeComplete compose by hand. Exists so
 * secondary surfaces (setup card, History chips/cards) render the SAME
 * Ionicons identity instead of the legacy catalog emoji — one recognizable
 * mark per mode, everywhere in the app.
 */
export function ModeMark({
  modeId,
  size = 24,
}: {
  modeId: GameModeId;
  /** Circle diameter, px (glyph scales with it). */
  size?: number;
}) {
  const id = MODE_IDENTITY[modeId];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: id.tint,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name={id.icon} size={Math.round(size * 0.55)} color={id.accent} />
    </View>
  );
}
