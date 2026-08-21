/**
 * Center-column game clock for the scoreboard: count-up stopwatch by default,
 * or a settable countdown (tap the mode chip to flip; countdown length is set
 * with +/- steppers while paused). Start/pause/reset controls below.
 *
 * Self-contained local timer — ticks every 250ms while running via
 * setInterval, driven off Date.now() deltas so backgrounding the app doesn't
 * drift the displayed time once it resumes (each tick recomputes from the
 * anchor timestamp rather than accumulating fixed steps).
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, font, radius, space, touch, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';

const TICK_MS = 250;
const COUNTDOWN_STEP_SEC = 30;
const COUNTDOWN_MIN_SEC = 30;
const COUNTDOWN_MAX_SEC = 60 * 60;
const DEFAULT_COUNTDOWN_SEC = 10 * 60;

function formatClock(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function GameClock() {
  const [mode, setMode] = useState<'countUp' | 'countdown'>('countUp');
  const [running, setRunning] = useState(false);
  /** Accumulated elapsed ms while stopped/paused (not counting the live run). */
  const bankedMs = useRef(0);
  /** Date.now() when the current run started; null while paused. */
  const runStartedAt = useRef<number | null>(null);
  const [countdownTotalSec, setCountdownTotalSec] = useState(DEFAULT_COUNTDOWN_SEC);
  /** Re-render trigger; the displayed value is always derived fresh from refs. */
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  const elapsedMs = () => {
    const live = runStartedAt.current != null ? Date.now() - runStartedAt.current : 0;
    return bankedMs.current + live;
  };

  const toggleRunning = () => {
    // Starting/stopping the clock is the gateway's medium-impact class.
    haptic.impactMedium();
    if (running) {
      bankedMs.current = elapsedMs();
      runStartedAt.current = null;
      setRunning(false);
    } else {
      runStartedAt.current = Date.now();
      setRunning(true);
    }
  };

  const reset = () => {
    haptic.selection();
    bankedMs.current = 0;
    runStartedAt.current = running ? Date.now() : null;
  };

  const swapMode = () => {
    // Tick only when the tap changes something — the chip is inert while running.
    if (running) return;
    haptic.selection();
    setMode((m) => (m === 'countUp' ? 'countdown' : 'countUp'));
    bankedMs.current = 0;
    runStartedAt.current = null;
  };

  const bumpCountdown = (deltaSec: number) => {
    if (running) return;
    haptic.selection();
    setCountdownTotalSec((s) =>
      Math.min(COUNTDOWN_MAX_SEC, Math.max(COUNTDOWN_MIN_SEC, s + deltaSec)),
    );
  };

  const elapsedSec = elapsedMs() / 1000;
  const displaySec = mode === 'countUp' ? elapsedSec : Math.max(0, countdownTotalSec - elapsedSec);
  const countdownDone = mode === 'countdown' && displaySec <= 0;

  // Auto-stop a countdown at zero so it doesn't run into negative time.
  useEffect(() => {
    if (countdownDone && running) {
      bankedMs.current = countdownTotalSec * 1000;
      runStartedAt.current = null;
      setRunning(false);
    }
  }, [countdownDone, running, countdownTotalSec]);

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={mode === 'countUp' ? 'Clock mode: count up. Switch to countdown' : 'Clock mode: countdown. Switch to count up'}
        accessibilityHint={running ? 'Pause the clock to switch modes' : undefined}
        disabled={running}
        onPress={swapMode}
        style={({ pressed }) => [styles.modeChip, pressed && !running && styles.modeChipPressed]}
      >
        <Text style={styles.modeChipLabel}>
          {mode === 'countUp' ? 'COUNT UP' : 'COUNTDOWN'}
        </Text>
      </Pressable>

      <Text
        accessibilityLabel={`Clock: ${formatClock(displaySec)}${countdownDone ? ', time up' : ''}`}
        style={[styles.clockText, countdownDone && { color: color.miss }]}
      >
        {formatClock(displaySec)}
      </Text>

      {mode === 'countdown' && !running && (
        <View style={styles.countdownSteppers}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Decrease countdown length by 30 seconds"
            disabled={countdownTotalSec <= COUNTDOWN_MIN_SEC}
            onPress={() => bumpCountdown(-COUNTDOWN_STEP_SEC)}
            style={({ pressed }) => [
              styles.stepButton,
              pressed && styles.stepButtonPressed,
              countdownTotalSec <= COUNTDOWN_MIN_SEC && styles.stepButtonDisabled,
            ]}
          >
            <Text style={styles.stepGlyph}>−</Text>
          </Pressable>
          <Text style={styles.countdownSetLabel}>SET LENGTH</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Increase countdown length by 30 seconds"
            disabled={countdownTotalSec >= COUNTDOWN_MAX_SEC}
            onPress={() => bumpCountdown(COUNTDOWN_STEP_SEC)}
            style={({ pressed }) => [
              styles.stepButton,
              pressed && styles.stepButtonPressed,
              countdownTotalSec >= COUNTDOWN_MAX_SEC && styles.stepButtonDisabled,
            ]}
          >
            <Text style={styles.stepGlyph}>+</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={running ? 'Pause clock' : 'Start clock'}
          onPress={toggleRunning}
          style={({ pressed }) => [
            styles.clockButton,
            styles.clockButtonPrimary,
            pressed && styles.clockButtonPressed,
          ]}
        >
          <Text style={styles.clockButtonLabel}>{running ? 'PAUSE' : 'START'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset clock"
          onPress={reset}
          style={({ pressed }) => [styles.clockButton, pressed && styles.clockButtonPressed]}
        >
          <Text style={styles.clockButtonLabelGhost}>RESET</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: space.sm,
  },
  modeChip: {
    minHeight: touch.minTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    // Plain boundary — hairline. borderWidth 1 is reserved for hierarchy.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeChipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  modeChipLabel: {
    ...type.caption,
    color: color.textDim,
  },
  clockText: {
    fontFamily: font.display,
    fontSize: 56,
    lineHeight: 58,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  countdownSteppers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  countdownSetLabel: {
    ...type.micro,
    color: color.textFaint,
  },
  stepButton: {
    width: touch.minTarget,
    height: touch.minTarget,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonPressed: {
    backgroundColor: color.surfaceRaised,
  },
  stepButtonDisabled: {
    opacity: 0.4,
  },
  stepGlyph: {
    ...type.heading,
    color: color.text,
  },
  controls: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.xs,
  },
  clockButton: {
    minWidth: touch.minTarget * 2,
    minHeight: touch.minTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockButtonPrimary: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  clockButtonPressed: {
    opacity: 0.85,
  },
  clockButtonLabel: {
    ...type.heading,
    color: color.onAccent,
  },
  clockButtonLabelGhost: {
    ...type.heading,
    color: color.text,
  },
});
