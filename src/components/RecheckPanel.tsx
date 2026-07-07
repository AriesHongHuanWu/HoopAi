/**
 * RecheckPanel — the "second look" affordance for recorded sessions with
 * unsure shots. One shared component so the summary and history screens stay
 * in lockstep: a ghost PillButton ("Re-check N unsure shots") that walks the
 * offline re-analysis (src/data/recheckRunner.ts) with a live progress line
 * ("Re-checking 2 of 3…") and lands on a quiet result chip ("Re-checked 3 —
 * corrected 2" / "no changes").
 *
 * The runner persists verdicts itself (db.updateShotOutcome, corrected=false);
 * `onVerdict` lets the host screen ALSO route each accepted verdict through
 * its existing optimistic-correction pathway so local shots/stats refresh
 * without a reload (the extra idempotent write is harmless by design).
 *
 * A run in flight is cancelled on unmount — already-persisted verdicts and
 * rechecked stamps stay, so nothing is lost or repeated.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, space, type } from '@/constants/tokens';
import { startSessionRecheck, type RecheckHandle, type RecheckRunResult } from '@/data/recheckRunner';
import { Chip, PillButton, Row } from '@/components/ui';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; index: number; total: number }
  | { kind: 'done'; checked: number; corrected: number }
  | { kind: 'unavailable' };

export function RecheckPanel({
  sessionId,
  unsureCount,
  onVerdict,
  style,
}: {
  sessionId: number;
  /** Unsure, uncorrected shots as the host screen currently sees them. */
  unsureCount: number;
  /** Route an accepted verdict through the screen's correction pathway. */
  onVerdict: (shotIndex: number, outcome: 'make' | 'miss') => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const handleRef = useRef<RecheckHandle | null>(null);
  const mountedRef = useRef(true);
  // Ref (not state) — the async completion handler reads the LATEST callback.
  const onVerdictRef = useRef(onVerdict);
  onVerdictRef.current = onVerdict;

  // Cancel a run in flight when the screen goes away.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      handleRef.current?.cancel();
    };
  }, []);

  const start = () => {
    if (handleRef.current !== null) return; // one run per screen visit
    setPhase({ kind: 'running', index: 1, total: unsureCount });
    const handle = startSessionRecheck(sessionId, (index, total) => {
      if (mountedRef.current) setPhase({ kind: 'running', index, total });
    });
    handleRef.current = handle;
    void handle.promise.then((result: RecheckRunResult) => {
      if (!mountedRef.current) return;
      for (const c of result.corrections) onVerdictRef.current(c.shotIndex, c.outcome);
      if (result.failure === 'no-model' || result.failure === 'no-recording') {
        setPhase({ kind: 'unavailable' });
      } else {
        setPhase({
          kind: 'done',
          checked: result.checked,
          corrected: result.corrections.length,
        });
      }
    });
  };

  if (phase.kind === 'idle') {
    if (unsureCount === 0) return null;
    return (
      <PillButton
        variant="ghost"
        icon="refresh"
        label={`Re-check ${unsureCount} unsure shot${unsureCount === 1 ? '' : 's'}`}
        onPress={start}
        style={style}
      />
    );
  }

  if (phase.kind === 'running') {
    return (
      <Row gap={space.md} style={[styles.progressRow, style]}>
        <ActivityIndicator color={color.accent} />
        <Text
          style={styles.progressText}
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Re-checking shot ${phase.index} of ${phase.total}`}
        >
          Re-checking {phase.index} of {phase.total}…
        </Text>
      </Row>
    );
  }

  if (phase.kind === 'unavailable') {
    return (
      <View style={[styles.chipWrap, style]}>
        <Chip label="Re-check unavailable on this device" tone="unsure" />
      </View>
    );
  }

  return (
    <View style={[styles.chipWrap, style]}>
      <Chip
        label={
          phase.checked === 0
            ? 'Already re-checked — no changes'
            : phase.corrected > 0
              ? `Re-checked ${phase.checked} — corrected ${phase.corrected}`
              : `Re-checked ${phase.checked} — no changes`
        }
        tone={phase.corrected > 0 ? 'make' : 'default'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  progressRow: {
    justifyContent: 'center',
    paddingVertical: space.sm,
  },
  progressText: {
    ...type.body,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  chipWrap: {
    alignItems: 'center',
  },
});
