/**
 * FtSeedChip — the one-time, entirely OPTIONAL free-throw seed offer that
 * replaces the legacy stand-and-hold FtCalibrationChip at the same live-HUD
 * mount point (rim locked, no tick-driven mode).
 *
 * The upgrade: instead of asking the player to stand frozen through a 3-2-1,
 * their FIRST SHOT from the free-throw line is the anchor — the pipeline
 * derives scale + heading from the shot's own origin, make or miss (the
 * anchor is the shooter's position, outcome-independent). The legacy
 * stand-and-hold countdown stays available as the secondary action for
 * players who can't shoot yet.
 *
 * Honesty rules baked into the copy: measurement is never claimed before the
 * pipeline confirms success, and every failure path says distances stay
 * ESTIMATED. Failure is quiet and non-punishing — skipping (or failing)
 * leaves the default rim-width ruler untouched. Per-session only; the sole
 * persisted artifact is the existing lastFtCalSummary receipt ({ ts } shape,
 * unchanged — no settings migration).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { haptic } from '@/utils/haptics';

import { color, space, type } from '../../constants/tokens';
import type { FtCaptureOutcome } from '../../pipeline/shotPipeline';
import { useSettings } from '../../state/settingsStore';
import { Row } from '../ui';
import { HudChip } from './HudChip';

/** How long the untouched offer lingers after rim lock before self-hiding. */
export const FT_OFFER_MS = 20000;
/** How long the success/failure beat (and the transient miss-read note) stays up. */
export const FT_RESULT_MS = 2500;

/**
 * Per-attempt seed feedback pushed by the pipeline after each RESOLVED shot
 * while the seed is armed. Structural mirror of shotPipeline's FtSeedFeedback
 * so this file compiles independently of merge order — once shotPipeline.ts
 * exports FtSeedFeedback, replace this alias with
 * `import type { FtSeedFeedback } from '../../pipeline/shotPipeline';`
 * (the shapes are structurally identical, so the swap changes nothing).
 */
export type FtSeedFeedback = { ok: true } | { ok: false; shotsLeft: number };

/**
 * Chip lifecycle. 'armed' waits on shot-derived seed feedback; the
 * 'standCountdown' → 'standCapturing' pair is the legacy hold-still flow.
 */
type Stage =
  | 'offer'
  | 'armed'
  | 'standCountdown'
  | 'standCapturing'
  | 'done'
  | 'failed'
  | 'hidden';

export function FtSeedChip({
  armSeed,
  cancelSeed,
  captureStandStill,
  feedback,
}: {
  /** Arm the pipeline: the next up-to-3 resolved shots attempt seed derivation. */
  armSeed: () => void;
  /** Disarm a pending seed (the ✕ on the armed chip). */
  cancelSeed: () => void;
  /** Legacy stand-and-hold anchor capture (captureFtAnchor under the hood). */
  captureStandStill: () => Promise<FtCaptureOutcome>;
  /**
   * Latest per-shot seed result while armed; null until the first attempt.
   * The pipeline pushes a FRESH object per attempt — reactions are keyed on
   * object identity, so equal-looking payloads still re-trigger.
   */
  feedback: FtSeedFeedback | null;
}) {
  const [stage, setStage] = useState<Stage>('offer');
  const [count, setCount] = useState(3);
  /** Transient armed-state sub-line after an unreadable attempt. */
  const [missNote, setMissNote] = useState<string | null>(null);
  /**
   * The feedback object that was ALREADY present when the user armed the
   * seed — a leftover from a previous seed lifecycle (the engine clears it
   * on arm/cancel/re-aim, but this guard makes the chip safe on its own).
   * The armed effect ignores exactly this reference, so only feedback
   * produced AFTER arming is ever acted on; without it, a re-mounted chip
   * would instantly replay a stale {ok:true} as "Court anchored" (and write
   * a false persisted receipt) while the fresh pipeline arm is still pending.
   */
  const staleFeedbackRef = useRef<FtSeedFeedback | null>(null);

  // Untouched offer self-hides — the seed must never nag or feel required.
  useEffect(() => {
    if (stage !== 'offer') return;
    const id = setTimeout(() => setStage('hidden'), FT_OFFER_MS);
    return () => clearTimeout(id);
  }, [stage]);

  // Armed: react to per-shot seed feedback from the pipeline. Success writes
  // the same persisted FT-cal receipt the legacy chip wrote (shape { ts },
  // consumed by the setup/settings calibration health card). Failure with
  // tries left stays armed and only shows a quiet, honest sub-line.
  useEffect(() => {
    if (feedback == null || stage !== 'armed') return;
    // Stale-replay guard: never consume the payload that predates this arm.
    if (feedback === staleFeedbackRef.current) return;
    if (feedback.ok) {
      useSettings.getState().set('lastFtCalSummary', { ts: Date.now() });
      setStage('done');
    } else if (feedback.shotsLeft > 0) {
      setMissNote(
        `Couldn't read that one — ${feedback.shotsLeft} left. Distances stay estimated.`,
      );
    } else {
      setStage('failed');
    }
  }, [feedback, stage]);

  // The miss-read sub-line is transient — it informs, then gets out of the way.
  useEffect(() => {
    if (missNote == null) return;
    const id = setTimeout(() => setMissNote(null), FT_RESULT_MS);
    return () => clearTimeout(id);
  }, [missNote]);

  // Legacy 3-2-1 hold-still countdown, then fire the capture.
  useEffect(() => {
    if (stage !== 'standCountdown') return;
    if (count <= 0) {
      setStage('standCapturing');
      return;
    }
    const id = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [stage, count]);

  useEffect(() => {
    if (stage !== 'standCapturing') return;
    let alive = true;
    captureStandStill()
      .then((r) => {
        if (r.ok) {
          // Persisted FT-cal receipt for the calibration health card
          // (setup/settings surfaces) — identical to the legacy chip.
          useSettings.getState().set('lastFtCalSummary', { ts: Date.now() });
        }
        if (alive) setStage(r.ok ? 'done' : 'failed');
      })
      .catch(() => {
        if (alive) setStage('failed');
      });
    return () => {
      alive = false;
    };
  }, [stage, captureStandStill]);

  // Brief result beat, then gone for the rest of the session.
  useEffect(() => {
    if (stage !== 'done' && stage !== 'failed') return;
    const id = setTimeout(() => setStage('hidden'), FT_RESULT_MS);
    return () => clearTimeout(id);
  }, [stage]);

  if (stage === 'hidden') return null;

  if (stage === 'offer') {
    return (
      <View style={styles.topCenter}>
        {/* The chip + row stretch to the HUD column and the copy Pressable is
            the ONLY shrinking region (flex:1 + minWidth:0, Text flexShrink +
            2 lines). RN Text in a row defaults to flexShrink 0, so the long
            copy used to push the ✕ dismiss outside the chip where HudChip's
            overflow:hidden clipped it away — worst in the landscape docked
            column (300px, floor 220px). The ✕ sits after the shrink region
            at its intrinsic width, so it can never be squeezed out. */}
        <HudChip style={styles.ftChip}>
          <View style={styles.ftBody}>
            <Row gap={space.sm} style={styles.ftRow}>
              <Pressable
                onPress={() => {
                  // Snapshot whatever feedback is lingering from a previous
                  // seed BEFORE arming — the armed effect skips exactly it.
                  staleFeedbackRef.current = feedback;
                  armSeed();
                  haptic.selection();
                  setStage('armed');
                }}
                accessibilityRole="button"
                accessibilityLabel="Measure the court from your first free throw. Shoot your first shot from the free-throw line."
                hitSlop={8}
                style={styles.ftTextPress}
              >
                <Text style={styles.ftText} numberOfLines={2}>
                  Starting at the FT line? Your first shot measures the court
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setStage('hidden')}
                accessibilityRole="button"
                accessibilityLabel="Dismiss court measurement tip"
                hitSlop={8}
              >
                <Text style={styles.ftDismiss}>✕</Text>
              </Pressable>
            </Row>
            {/* Secondary path — the legacy stand-and-hold ritual for players
                who can't (or don't want to) shoot the anchor. */}
            <Pressable
              onPress={() => {
                setCount(3);
                setStage('standCountdown');
                haptic.selection();
              }}
              accessibilityRole="button"
              accessibilityLabel="Can't shoot yet? Stand still at the free-throw line for a countdown instead."
              hitSlop={8}
              style={styles.ftAltPress}
            >
              <Text style={styles.ftAltText}>Can't shoot? Stand &amp; hold</Text>
            </Pressable>
          </View>
        </HudChip>
      </View>
    );
  }

  if (stage === 'armed') {
    return (
      <View style={styles.topCenter}>
        {/* Same shrink-region contract as the offer: the status Text region
            is the only shrinking child, the ✕ keeps its intrinsic width. */}
        <HudChip style={styles.ftChip}>
          <View style={styles.ftBody}>
            <Row gap={space.sm} style={styles.ftRow}>
              <View style={styles.ftTextPress}>
                <Text
                  style={styles.ftText}
                  numberOfLines={2}
                  accessibilityLiveRegion="polite"
                >
                  FT shot armed — shoot from the line
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  cancelSeed();
                  setStage('hidden');
                }}
                accessibilityRole="button"
                accessibilityLabel="Cancel the free-throw measurement"
                hitSlop={8}
              >
                <Text style={styles.ftDismiss}>✕</Text>
              </Pressable>
            </Row>
            {missNote != null && (
              <Text
                style={styles.ftSubText}
                numberOfLines={2}
                accessibilityLiveRegion="polite"
              >
                {missNote}
              </Text>
            )}
          </View>
        </HudChip>
      </View>
    );
  }

  // Countdown / capturing / result beats — non-interactive status only.
  // Success copy appears ONLY here, after the pipeline confirmed the anchor;
  // the failure beat keeps the honest "estimated" framing.
  const label =
    stage === 'standCountdown'
      ? `Hold still at the line… ${count}`
      : stage === 'standCapturing'
        ? 'Hold still at the line…'
        : stage === 'done'
          ? 'Court anchored — 2s and 3s now measured'
          : 'No luck — keeping estimated distances';
  return (
    <View style={styles.topCenter} pointerEvents="none">
      <HudChip>
        <Text
          style={
            stage === 'done'
              ? styles.ftDoneText
              : stage === 'failed'
                ? styles.ftFailText
                : styles.ftText
          }
          accessibilityLiveRegion="polite"
        >
          {label}
        </Text>
      </HudChip>
    </View>
  );
}

const styles = StyleSheet.create({
  topCenter: {
    alignItems: 'center',
    marginTop: space.sm,
  },
  /** Offer chip spans the HUD column so the flex:1 copy region has real
   *  width to fill (an auto-width chip would collapse a flex-basis-0 child). */
  ftChip: {
    alignSelf: 'stretch',
  },
  /** Column wrapper (main row + optional secondary/sub line) — stretched so
   *  the inner row owns the full chip width, same as ftRow. */
  ftBody: {
    alignSelf: 'stretch',
  },
  /** HudChip centers children; stretch the row so it owns the full width. */
  ftRow: {
    alignSelf: 'stretch',
  },
  /** The one shrinking region — minWidth:0 lets the Text actually wrap. */
  ftTextPress: {
    flex: 1,
    minWidth: 0,
  },
  ftText: {
    ...type.bodyMedium,
    color: color.text,
    flexShrink: 1,
  },
  ftDoneText: {
    ...type.bodyMedium,
    color: color.make,
  },
  ftFailText: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  ftDismiss: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  /** Secondary stand-and-hold action, quiet under the main offer copy. */
  ftAltPress: {
    alignSelf: 'flex-start',
    marginTop: space.xs,
  },
  ftAltText: {
    ...type.caption,
    color: color.textDim,
  },
  /** Transient miss-read note under the armed status line. */
  ftSubText: {
    ...type.caption,
    color: color.textDim,
    marginTop: space.xs,
  },
});
