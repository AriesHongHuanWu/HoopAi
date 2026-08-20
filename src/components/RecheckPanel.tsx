/**
 * RecheckPanel — the unsure-shot triage flow for recorded sessions. One shared
 * component so the summary and history screens stay in lockstep:
 *
 *   idle    → ribbon ("The AI left N shots undecided — honest, not lazy.") +
 *             ghost PillButton that starts the offline re-analysis
 *             (src/data/recheckRunner.ts)
 *   running → live progress line ("Re-checking 2 of 3…")
 *   triage  → result chip + "Still unsure — you decide" rows with Make/Miss
 *             buttons for the shots the machine STILL couldn't call
 *   done    → quiet result chip ("Re-checked 3 — corrected 2" / "no changes")
 *
 * Honesty invariant: machine verdicts flow ONLY through startSessionRecheck →
 * result.corrections → onVerdict (the runner persists with corrected=false —
 * machine re-reads never get the Edited badge). Hand verdicts from the triage
 * rows route through `onManualCorrect`, where the host's applyCorrection
 * pathway defaults corrected=TRUE — hand calls DO earn the Edited badge.
 * Leaving triage rows untouched is always allowed; unsure is a legitimate
 * final state.
 *
 * Both new props are optional: without them the panel degrades to the classic
 * run-and-report behavior plus a swipe-to-correct hint line.
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
  | {
      kind: 'running';
      index: number;
      total: number;
      // The runner delivers verdicts only in the final RecheckRunResult (no
      // per-shot stream), so this stays empty today — kept in the model so a
      // future streaming runner can light up a live ticker without a reshape.
      corrections: readonly { shotIndex: number; outcome: 'make' | 'miss' }[];
    }
  | { kind: 'triage'; checked: number; corrected: number; remaining: number[] }
  | { kind: 'done'; checked: number; corrected: number }
  | { kind: 'unavailable' };

/** Result chip shared by the triage and done phases. */
function ResultChip({ checked, corrected }: { checked: number; corrected: number }) {
  return (
    <Chip
      label={
        checked === 0
          ? 'Already re-checked — no changes'
          : corrected > 0
            ? `Re-checked ${checked} — corrected ${corrected}`
            : `Re-checked ${checked} — no changes`
      }
      tone={corrected > 0 ? 'make' : 'default'}
    />
  );
}

export function RecheckPanel({
  sessionId,
  unsureCount,
  onVerdict,
  unsureShotIndexes,
  onManualCorrect,
  style,
}: {
  sessionId: number;
  /** Unsure, uncorrected shots as the host screen currently sees them. */
  unsureCount: number;
  /** Route an accepted MACHINE verdict through the screen's correction pathway. */
  onVerdict: (shotIndex: number, outcome: 'make' | 'miss') => void;
  /**
   * Session-local shot indexes (ResolvedShot.id) of the currently-unsure,
   * uncorrected shots. Lets the post-run triage list render without a db
   * read; omit it and the panel falls back to run-and-report.
   */
  unsureShotIndexes?: readonly number[];
  /**
   * Route a HAND verdict through the host's applyCorrection pathway, where
   * corrected defaults to TRUE — the user's call earns the Edited badge
   * (machine re-reads via onVerdict never do). Omit it to disable triage.
   */
  onManualCorrect?: (shotIndex: number, outcome: 'make' | 'miss') => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Shown in 'done' when shots stayed unsure but triage couldn't be offered.
  const [showSwipeHint, setShowSwipeHint] = useState(false);
  const handleRef = useRef<RecheckHandle | null>(null);
  const mountedRef = useRef(true);
  // Refs (not state) — the async completion handler reads the LATEST values.
  const onVerdictRef = useRef(onVerdict);
  onVerdictRef.current = onVerdict;
  const onManualCorrectRef = useRef(onManualCorrect);
  onManualCorrectRef.current = onManualCorrect;
  const unsureIndexesRef = useRef(unsureShotIndexes);
  unsureIndexesRef.current = unsureShotIndexes;

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
    setPhase({ kind: 'running', index: 1, total: unsureCount, corrections: [] });
    const handle = startSessionRecheck(sessionId, (index, total) => {
      if (!mountedRef.current) return;
      setPhase((p) => ({
        kind: 'running',
        index,
        total,
        corrections: p.kind === 'running' ? p.corrections : [],
      }));
    });
    handleRef.current = handle;
    void handle.promise.then((result: RecheckRunResult) => {
      if (!mountedRef.current) return;
      for (const c of result.corrections) onVerdictRef.current(c.shotIndex, c.outcome);
      if (result.failure === 'no-model' || result.failure === 'no-recording') {
        setPhase({ kind: 'unavailable' });
        return;
      }
      const indexes = unsureIndexesRef.current;
      const remaining = (indexes ?? []).filter(
        (i) => !result.corrections.some((c) => c.shotIndex === i),
      );
      // Without the index list, infer leftovers from the run itself so the
      // degraded panel can still point at the swipe-to-correct pathway.
      const leftover =
        indexes != null ? remaining.length : Math.max(0, result.checked - result.corrections.length);
      if (remaining.length > 0 && onManualCorrectRef.current != null) {
        setPhase({
          kind: 'triage',
          checked: result.checked,
          corrected: result.corrections.length,
          remaining,
        });
      } else {
        setShowSwipeHint(leftover > 0);
        setPhase({
          kind: 'done',
          checked: result.checked,
          corrected: result.corrections.length,
        });
      }
    });
  };

  const resolveManually = (shotIndex: number, outcome: 'make' | 'miss') => {
    // Hand verdict — corrected defaults to TRUE in the host pathway (Edited
    // badge). NOT counted into `corrected`, which tallies machine re-reads.
    onManualCorrectRef.current?.(shotIndex, outcome);
    setPhase((p) => {
      if (p.kind !== 'triage') return p;
      const remaining = p.remaining.filter((i) => i !== shotIndex);
      if (remaining.length === 0) return { kind: 'done', checked: p.checked, corrected: p.corrected };
      return { ...p, remaining };
    });
  };

  if (phase.kind === 'idle') {
    if (unsureCount === 0) return null;
    return (
      <View style={style}>
        <Text style={styles.ribbon}>
          The AI left {unsureCount} shot{unsureCount === 1 ? '' : 's'} undecided — honest, not
          lazy.
        </Text>
        <PillButton
          variant="ghost"
          icon="refresh"
          label={`Re-check ${unsureCount} unsure shot${unsureCount === 1 ? '' : 's'}`}
          onPress={start}
        />
      </View>
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

  if (phase.kind === 'triage') {
    return (
      <View style={[styles.chipWrap, style]}>
        <ResultChip checked={phase.checked} corrected={phase.corrected} />
        <Text style={styles.triageHeader}>Still unsure — you decide</Text>
        <View style={styles.triageList}>
          {phase.remaining.map((shotIndex) => (
            <Row key={shotIndex} style={styles.triageRow}>
              {/* shotIndex IS ResolvedShot.id, already the 1-based display
                  number ShotList/ShotInfoStrip render as `Shot {id}` — no +1,
                  or the triage row would name a DIFFERENT shot than the list. */}
              <Text style={styles.triageLabel}>Shot {shotIndex}</Text>
              <Row gap={space.sm}>
                <PillButton
                  variant="ghost"
                  icon="checkmark"
                  label="Make"
                  onPress={() => resolveManually(shotIndex, 'make')}
                />
                <PillButton
                  variant="ghost"
                  icon="close"
                  label="Miss"
                  onPress={() => resolveManually(shotIndex, 'miss')}
                />
              </Row>
            </Row>
          ))}
        </View>
        <Text style={styles.triageFooter}>
          Your calls get an Edited badge — machine re-checks don’t.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.chipWrap, style]}>
      <ResultChip checked={phase.checked} corrected={phase.corrected} />
      {showSwipeHint && (
        <Text style={styles.hint}>Still unsure? Swipe any shot in the list to correct it.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ribbon: {
    ...type.micro,
    color: color.textDim,
    textAlign: 'center',
    marginBottom: space.sm,
  },
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
  triageHeader: {
    ...type.caption,
    color: color.text,
    marginTop: space.md,
    textAlign: 'center',
  },
  triageList: {
    alignSelf: 'stretch',
  },
  triageRow: {
    justifyContent: 'space-between',
    paddingVertical: space.sm,
  },
  triageLabel: {
    ...type.body,
    color: color.text,
  },
  triageFooter: {
    ...type.micro,
    color: color.textFaint,
    textAlign: 'center',
    marginTop: space.sm,
  },
  hint: {
    ...type.micro,
    color: color.textFaint,
    textAlign: 'center',
    marginTop: space.sm,
  },
});
