/**
 * StatStrip — the three glanceable numbers on the live HUD:
 * makes-attempts ("7/10"), FG% and current streak, in broadcast numerals on
 * hudGlass chips. Subscribes to the session store with narrow selectors so it
 * only re-renders when a shot resolves.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, space } from '../../constants/tokens';
import { useSession } from '../../state/sessionStore';
import { Row, StatNumber } from '../ui';
import { HudChip } from './HudChip';

export function StatStrip({ style }: { style?: StyleProp<ViewStyle> }) {
  const makes = useSession((s) => s.stats.makes);
  const attempts = useSession((s) => s.stats.attempts);
  const fgPct = useSession((s) => s.stats.fgPct);
  const streak = useSession((s) => s.stats.currentStreak);

  const hot = streak >= 3;
  return (
    <View
      accessible
      accessibilityLabel={`${makes} makes of ${attempts} attempts, ${Math.round(fgPct * 100)} percent field goal, streak ${streak}`}
      style={style}
    >
      <Row style={styles.strip} gap={space.sm}>
        <HudChip>
          <StatNumber value={`${makes}/${attempts}`} label="Makes" size="large" />
        </HudChip>
        <HudChip>
          <StatNumber value={`${Math.round(fgPct * 100)}`} label="FG%" size="medium" />
        </HudChip>
        <HudChip>
          <StatNumber
            value={hot ? `🔥${streak}` : `${streak}`}
            label="Streak"
            size="medium"
            tint={hot ? color.accent : undefined}
          />
        </HudChip>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    justifyContent: 'center',
    alignItems: 'stretch',
  },
});
